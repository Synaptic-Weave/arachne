export class AdminUser {
  id!: string;
  username!: string;
  passwordHash!: string;
  mustChangePassword!: boolean;
  createdAt!: Date;
  lastLogin!: Date | null;
}
