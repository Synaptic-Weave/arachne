export class Settings {
  id!: number;
  signupsEnabled!: boolean;
  defaultEmbedderProvider!: string | null;
  defaultEmbedderModel!: string | null;
  defaultEmbedderApiKey!: string | null;
  defaultEmbedderProviderId!: string | null;
  updatedAt!: Date;
  updatedByAdminId!: string | null;

  constructor() {
    this.id = 1; // Singleton - always use id = 1
    this.signupsEnabled = true;
    this.defaultEmbedderProvider = null;
    this.defaultEmbedderModel = null;
    this.defaultEmbedderApiKey = null;
    this.defaultEmbedderProviderId = null;
    this.updatedAt = new Date();
    this.updatedByAdminId = null;
  }

  updateSignupsEnabled(enabled: boolean, adminId: string): void {
    this.signupsEnabled = enabled;
    this.updatedAt = new Date();
    this.updatedByAdminId = adminId;
  }

  updateEmbedderConfig(
    provider: string | null,
    model: string | null,
    apiKey: string | null,
    adminId: string,
  ): void {
    this.defaultEmbedderProvider = provider;
    this.defaultEmbedderModel = model;
    this.defaultEmbedderApiKey = apiKey;
    this.updatedAt = new Date();
    this.updatedByAdminId = adminId;
  }

  updateEmbedderProviderRef(
    providerId: string | null,
    model: string | null,
    adminId: string,
  ): void {
    this.defaultEmbedderProviderId = providerId;
    this.defaultEmbedderModel = model;
    // Clear legacy fields when using provider ref
    this.defaultEmbedderProvider = null;
    this.defaultEmbedderApiKey = null;
    this.updatedAt = new Date();
    this.updatedByAdminId = adminId;
  }
}
