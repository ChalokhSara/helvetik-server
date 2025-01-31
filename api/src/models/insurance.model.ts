interface Insurance {
  id: string;
  type: 'HEALTH' | 'ACCIDENT' | 'LIABILITY' | 'LIFE';
  policyNumber: string;
  startDate: Date;
  endDate: Date;
  premium: number;
  coverage: {
    type: string;
    amount: number;
    description: string;
  }[];
  userId: string;
  status: 'ACTIVE' | 'PENDING' | 'CANCELLED';
} 