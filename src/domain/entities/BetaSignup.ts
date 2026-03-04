import { randomUUID } from 'node:crypto';

export class BetaSignup {
  id!: string;
  email!: string;
  name!: string | null;
  inviteCode!: string | null;
  approvedAt!: Date | null;
  approvedByAdminId!: string | null;
  inviteUsedAt!: Date | null;
  createdAt!: Date;

  constructor(email: string, name?: string | null) {
    this.id = randomUUID();
    this.email = email;
    this.name = name ?? null;
    this.inviteCode = null;
    this.approvedAt = null;
    this.approvedByAdminId = null;
    this.inviteUsedAt = null;
    this.createdAt = new Date();
  }

  approve(adminId: string): void {
    this.inviteCode = randomUUID();
    this.approvedAt = new Date();
    this.approvedByAdminId = adminId;
  }

  markAsUsed(): void {
    this.inviteUsedAt = new Date();
  }
}
