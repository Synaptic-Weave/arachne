import { randomUUID } from 'node:crypto';

export class BetaSignup {
  id!: string;
  email!: string;
  name!: string | null;
  createdAt!: Date;

  constructor(email: string, name?: string | null) {
    this.id = randomUUID();
    this.email = email;
    this.name = name ?? null;
    this.createdAt = new Date();
  }
}
