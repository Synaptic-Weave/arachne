export class Settings {
  id!: number;
  signupsEnabled!: boolean;
  updatedAt!: Date;
  updatedByAdminId!: string | null;

  constructor() {
    this.id = 1; // Singleton - always use id = 1
    this.signupsEnabled = true;
    this.updatedAt = new Date();
    this.updatedByAdminId = null;
  }

  updateSignupsEnabled(enabled: boolean, adminId: string): void {
    this.signupsEnabled = enabled;
    this.updatedAt = new Date();
    this.updatedByAdminId = adminId;
  }
}
