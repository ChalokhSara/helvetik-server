interface Claim {
  id: string;
  insuranceId: string;
  userId: string;
  type: string;
  description: string;
  date: Date;
  amount: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  documents: {
    name: string;
    url: string;
    type: string;
  }[];
} 