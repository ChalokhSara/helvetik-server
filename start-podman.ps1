<#
.SYNOPSIS
  Démarre la pile Helvetik avec Podman, quand Docker Desktop n'est pas utilisable.

.DESCRIPTION
  Trois étapes, chacune sautée si elle est déjà faite :

    1. la machine virtuelle Podman ;
    2. son relais Windows (win-sshproxy), qui expose Podman sur le pipe
       \\.\pipe\<machine>. C'est par lui que passe `podman compose` ;
    3. la pile du docker-compose.yml, puis l'attente de /health.

  Pourquoi relancer le relais à la main : `podman machine start` le lance
  avec deux pipes, le sien et \\.\pipe\docker_engine. Tant que Docker Desktop
  est installé, ce second pipe le fait échouer sans un mot, et `podman compose`
  répond « open //./pipe/podman-machine-default: The system cannot find the
  file specified ». Lancé avec son seul pipe, il fonctionne. Après un
  redémarrage du PC, la machine WSL repart parfois seule mais sans relais : le
  script couvre aussi ce cas.

  Les images publiques sont tirées sans identifiants : des identifiants
  Docker Hub périmés, hérités de Docker Desktop, font sinon échouer la
  construction de l'image de l'API.

.EXAMPLE
  ./start-podman.ps1            # démarre tout
  ./start-podman.ps1 --build    # reconstruit l'image de l'API (après un changement de dépendances)
#>
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ComposeArgs = @()
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Step($text) { Write-Host "-> $text" -ForegroundColor Cyan }

if (-not (Get-Command podman -ErrorAction SilentlyContinue)) {
    throw 'Podman est introuvable. Installez Podman Desktop ou Podman pour Windows.'
}

# --- 1. machine virtuelle ---------------------------------------------------

$machine = (podman machine list --format '{{.Name}}' | Where-Object { $_ -match '\*$' } | Select-Object -First 1)
if (-not $machine) {
    $machine = podman machine list --format '{{.Name}}' | Select-Object -First 1
}
$machine = "$machine".TrimEnd('*').Trim()
if (-not $machine) {
    throw 'Aucune machine Podman. Créez-en une : podman machine init'
}

$state = podman machine inspect $machine --format '{{.State}}'
if ($state -ne 'running') {
    Step "Démarrage de la machine Podman « $machine »"
    # Le relais qu'elle tente de lancer échoue : l'avertissement est attendu.
    podman machine start $machine 2>&1 | Out-Null
} else {
    Step "Machine Podman « $machine » déjà démarrée"
}

# --- 2. relais Windows ------------------------------------------------------

$pipe = "\\.\pipe\$machine"
if (Test-Path $pipe) {
    Step 'Relais Windows déjà actif'
} else {
    Step 'Démarrage du relais Windows (win-sshproxy)'

    $connection = podman system connection list --format json | ConvertFrom-Json |
        Where-Object { $_.Name -eq $machine } | Select-Object -First 1
    if (-not $connection) {
        throw "Connexion Podman « $machine » introuvable (podman system connection list)."
    }

    $proxy = Join-Path (Split-Path (Get-Command podman).Source) 'win-sshproxy.exe'
    if (-not (Test-Path $proxy)) {
        throw "win-sshproxy.exe introuvable à côté de podman.exe ($proxy)."
    }

    # Dossier d'état de la machine : le relais y note son identifiant de processus.
    $stateDir = Join-Path $env:USERPROFILE ".local\share\containers\podman\machine\wsl\$machine"
    New-Item -ItemType Directory -Force $stateDir | Out-Null

    # Un relais orphelin d'un démarrage raté ne tient aucun pipe : le remplacer.
    Get-Process win-sshproxy -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    Start-Process -FilePath $proxy -WindowStyle Hidden -ArgumentList @(
        $machine, $stateDir,
        "npipe:////./pipe/$machine", $connection.URI, $connection.Identity
    )

    $deadline = (Get-Date).AddSeconds(15)
    while (-not (Test-Path $pipe) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
    if (-not (Test-Path $pipe)) {
        throw "Le relais n'a pas ouvert $pipe. Essayez : podman machine stop; puis relancez ce script."
    }
}

# --- 3. pile Helvetik -------------------------------------------------------

$anonymous = Join-Path $env:TEMP 'helvetik-podman-anonymous-auth.json'
Set-Content -Path $anonymous -Value '{}' -Encoding ascii
$env:REGISTRY_AUTH_FILE = $anonymous

# `podman build` lit REGISTRY_AUTH_FILE, mais l'image de base est tirée par
# le service de la machine : la tirer d'abord, sans identifiants, évite l'échec.
$baseImage = (Select-String -Path 'api\Dockerfile' -Pattern '^\s*FROM\s+(\S+)' | Select-Object -First 1).Matches.Groups[1].Value
if ($baseImage) {
    podman image exists $baseImage
    if ($LASTEXITCODE -ne 0) {
        Step "Téléchargement de l'image de base $baseImage"
        podman pull --authfile $anonymous "docker.io/library/$baseImage"
        if ($LASTEXITCODE -ne 0) { throw "Échec du téléchargement de $baseImage." }
    }
}

Step 'Démarrage de la pile (podman compose up -d)'
podman compose up -d @ComposeArgs 2>&1 | Where-Object { $_ -notmatch 'Executing external compose provider' }
if ($LASTEXITCODE -ne 0) { throw 'podman compose a échoué : voir les messages ci-dessus.' }

# Après un redémarrage du PC, l'API a pu repartir seule et s'arrêter faute de
# base : nodemon attend alors un changement de fichier. La relancer la remet en route.
podman compose restart api 2>&1 | Out-Null

Step "Attente de l'API"
$deadline = (Get-Date).AddSeconds(90)
$ready = $false
while (-not $ready -and (Get-Date) -lt $deadline) {
    try {
        $ready = (Invoke-WebRequest -Uri 'http://localhost:3000/health' -TimeoutSec 3 -UseBasicParsing).StatusCode -eq 200
    } catch { Start-Sleep -Seconds 2 }
}

if (-not $ready) {
    Write-Host "L'API ne répond pas encore. Journaux : podman compose logs --tail 50 api" -ForegroundColor Yellow
    exit 1
}

Write-Host ''
Write-Host 'Helvetik est démarré :' -ForegroundColor Green
Write-Host '  Site et API      http://localhost:3000'
Write-Host '  Console admin    http://localhost:3000/admin'
Write-Host '  Swagger          http://localhost:3000/api-docs'
Write-Host '  Mailpit          http://localhost:8025'
