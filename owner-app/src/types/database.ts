export type SourceStatus = "pending" | "processing" | "ready" | "failed";

export type ProjectRow = {
  id: string;
  owner_user_id: string;
  name: string;
  handle: string;
  allowed_origins: string[];
  rate_rpm: number;
  rate_burst: number;
  quota_daily_requests: number;
  quota_monthly_requests: number;
  quota_daily_tokens: number | null;
  quota_monthly_tokens: number | null;
  input_validation_prompt: string;
  output_validation_prompt: string;
  created_at: string;
  updated_at: string;
};

export type ProjectSourceRow = {
  id: string;
  project_id: string;
  source_type: "gdoc" | "gslides" | "gpdf";
  drive_file_id: string;
  title: string;
  status: SourceStatus;
  error: string | null;
  updated_at: string;
};

export type UsageDailyRow = {
  project_id: string;
  usage_date: string;
  requests: number;
  tokens_in: number;
  tokens_out: number;
};

export type UsageMonthlyRow = {
  project_id: string;
  month_start: string;
  requests: number;
  tokens_in: number;
  tokens_out: number;
};

export type AuditLogRow = {
  id: number;
  project_id: string;
  event_type: string;
  request_id: string;
  created_at: string;
  origin: string | null;
};

type TableDef<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
};

export type Database = {
  public: {
    Tables: {
      projects: TableDef<
        ProjectRow,
        Omit<ProjectRow, "id" | "created_at" | "updated_at"> &
          Partial<Pick<ProjectRow, "id" | "created_at" | "updated_at">>,
        Partial<Omit<ProjectRow, "id" | "owner_user_id" | "created_at">>
      >;
      project_sources: TableDef<ProjectSourceRow>;
      project_usage_daily: TableDef<UsageDailyRow>;
      project_usage_monthly: TableDef<UsageMonthlyRow>;
      audit_logs: TableDef<AuditLogRow>;
    };
  };
};
