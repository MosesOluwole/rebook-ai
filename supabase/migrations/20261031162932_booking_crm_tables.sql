CREATE TABLE "rebook"."availability_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT rebook.uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"team_member_id" uuid,
	"location_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_exceptions_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "availability_exceptions_kind_valid" CHECK ("rebook"."availability_exceptions"."kind" in ('time_off', 'closure')),
	CONSTRAINT "availability_exceptions_kind_subject" CHECK (("rebook"."availability_exceptions"."kind" = 'time_off') = ("rebook"."availability_exceptions"."team_member_id" is not null)),
	CONSTRAINT "availability_exceptions_ends_after_start" CHECK ("rebook"."availability_exceptions"."ends_at" > "rebook"."availability_exceptions"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "rebook"."availability_exceptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rebook"."daily_capacity_rules" (
	"id" uuid PRIMARY KEY DEFAULT rebook.uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_member_id" uuid NOT NULL,
	"max_events_per_date" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_capacity_rules_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "daily_capacity_rules_tenant_id_team_member_id_unique" UNIQUE("tenant_id","team_member_id"),
	CONSTRAINT "daily_capacity_rules_max_events_range" CHECK ("rebook"."daily_capacity_rules"."max_events_per_date" between 1 and 50)
);
--> statement-breakpoint
ALTER TABLE "rebook"."daily_capacity_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rebook"."services" (
	"id" uuid PRIMARY KEY DEFAULT rebook.uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"booking_mode" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"buffer_before_minutes" integer DEFAULT 0 NOT NULL,
	"buffer_after_minutes" integer DEFAULT 0 NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"location_type" text NOT NULL,
	"repeat_interval_days" integer,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "services_name_length" CHECK (length(btrim("rebook"."services"."name")) between 1 and 120),
	CONSTRAINT "services_booking_mode_valid" CHECK ("rebook"."services"."booking_mode" in ('timed', 'request')),
	CONSTRAINT "services_location_type_valid" CHECK ("rebook"."services"."location_type" in ('clinic', 'client_home', 'video', 'venue')),
	CONSTRAINT "services_duration_range" CHECK ("rebook"."services"."duration_minutes" between 5 and 1440),
	CONSTRAINT "services_buffers_range" CHECK ("rebook"."services"."buffer_before_minutes" between 0 and 240 and "rebook"."services"."buffer_after_minutes" between 0 and 240),
	CONSTRAINT "services_price_not_negative" CHECK ("rebook"."services"."price" >= 0),
	CONSTRAINT "services_currency_format" CHECK ("rebook"."services"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "services_repeat_interval_range" CHECK ("rebook"."services"."repeat_interval_days" is null or "rebook"."services"."repeat_interval_days" between 1 and 1095)
);
--> statement-breakpoint
ALTER TABLE "rebook"."services" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rebook"."staff_services" (
	"tenant_id" uuid NOT NULL,
	"team_member_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_services_pkey" PRIMARY KEY("tenant_id","team_member_id","service_id")
);
--> statement-breakpoint
ALTER TABLE "rebook"."staff_services" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rebook"."team_member_service_areas" (
	"tenant_id" uuid NOT NULL,
	"team_member_id" uuid NOT NULL,
	"postcode_district" text NOT NULL,
	CONSTRAINT "team_member_service_areas_pkey" PRIMARY KEY("tenant_id","team_member_id","postcode_district"),
	CONSTRAINT "team_member_service_areas_district_format" CHECK ("rebook"."team_member_service_areas"."postcode_district" ~ '^[A-Z]{1,2}[0-9][A-Z0-9]?$')
);
--> statement-breakpoint
ALTER TABLE "rebook"."team_member_service_areas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rebook"."team_members" (
	"id" uuid PRIMARY KEY DEFAULT rebook.uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"membership_id" uuid,
	"display_name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"travel_before_minutes" integer DEFAULT 0 NOT NULL,
	"travel_after_minutes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "team_members_tenant_id_membership_id_unique" UNIQUE("tenant_id","membership_id"),
	CONSTRAINT "team_members_display_name_length" CHECK (length(btrim("rebook"."team_members"."display_name")) between 1 and 80),
	CONSTRAINT "team_members_travel_range" CHECK ("rebook"."team_members"."travel_before_minutes" between 0 and 240 and "rebook"."team_members"."travel_after_minutes" between 0 and 240)
);
--> statement-breakpoint
ALTER TABLE "rebook"."team_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rebook"."working_hour_breaks" (
	"id" uuid PRIMARY KEY DEFAULT rebook.uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"working_hours_id" uuid NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	CONSTRAINT "working_hour_breaks_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "working_hour_breaks_start_before_end" CHECK ("rebook"."working_hour_breaks"."start_time" < "rebook"."working_hour_breaks"."end_time")
);
--> statement-breakpoint
ALTER TABLE "rebook"."working_hour_breaks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rebook"."working_hours" (
	"id" uuid PRIMARY KEY DEFAULT rebook.uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_member_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "working_hours_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "working_hours_weekday_valid" CHECK ("rebook"."working_hours"."weekday" between 1 and 7),
	CONSTRAINT "working_hours_start_before_end" CHECK ("rebook"."working_hours"."start_time" < "rebook"."working_hours"."end_time")
);
--> statement-breakpoint
ALTER TABLE "rebook"."working_hours" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rebook"."custom_field_definitions" (
	"id" uuid PRIMARY KEY DEFAULT rebook.uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"field_type" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"health_free_text_override" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_field_definitions_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "custom_field_definitions_tenant_id_id_entity_unique" UNIQUE("tenant_id","id","entity"),
	CONSTRAINT "custom_field_definitions_tenant_id_entity_key_unique" UNIQUE("tenant_id","entity","key"),
	CONSTRAINT "custom_field_definitions_entity_valid" CHECK ("rebook"."custom_field_definitions"."entity" in ('client', 'service')),
	CONSTRAINT "custom_field_definitions_type_valid" CHECK ("rebook"."custom_field_definitions"."field_type" in ('text', 'long_text', 'number', 'boolean', 'date', 'select', 'multi_select')),
	CONSTRAINT "custom_field_definitions_key_format" CHECK ("rebook"."custom_field_definitions"."key" ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "custom_field_definitions_label_length" CHECK (length(btrim("rebook"."custom_field_definitions"."label")) between 1 and 80),
	CONSTRAINT "custom_field_definitions_options_shape" CHECK (jsonb_typeof("rebook"."custom_field_definitions"."options") = 'array' and ("rebook"."custom_field_definitions"."field_type" in ('select', 'multi_select')) = (jsonb_array_length("rebook"."custom_field_definitions"."options") > 0)),
	CONSTRAINT "custom_field_definitions_override_only_free_text" CHECK (not "rebook"."custom_field_definitions"."health_free_text_override" or "rebook"."custom_field_definitions"."field_type" in ('text', 'long_text'))
);
--> statement-breakpoint
ALTER TABLE "rebook"."custom_field_definitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rebook"."custom_field_values" (
	"id" uuid PRIMARY KEY DEFAULT rebook.uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"service_id" uuid,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_field_values_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "custom_field_values_tenant_id_definition_id_service_id_unique" UNIQUE("tenant_id","definition_id","service_id"),
	CONSTRAINT "custom_field_values_subject" CHECK ("rebook"."custom_field_values"."entity" = 'service' and "rebook"."custom_field_values"."service_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "rebook"."custom_field_values" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rebook"."availability_exceptions" ADD CONSTRAINT "availability_exceptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "rebook"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook"."availability_exceptions" ADD CONSTRAINT "availability_exceptions_team_member_fk" FOREIGN KEY ("tenant_id","team_member_id") REFERENCES "rebook"."team_members"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook"."availability_exceptions" ADD CONSTRAINT "availability_exceptions_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "rebook"."locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook"."daily_capacity_rules" ADD CONSTRAINT "daily_capacity_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "rebook"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook"."daily_capacity_rules" ADD CONSTRAINT "daily_capacity_rules_team_member_fk" FOREIGN KEY ("tenant_id","team_member_id") REFERENCES "rebook"."team_members"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook"."services" ADD CONSTRAINT "services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "rebook"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook"."staff_services" ADD CONSTRAINT "staff_services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "rebook"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook"."staff_services" ADD CONSTRAINT "staff_services_team_member_fk" FOREIGN KEY ("tenant_id","team_member_id") REFERENCES "rebook"."team_members"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook"."staff_services" ADD CONSTRAINT "staff_services_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "rebook"."services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook"."team_member_service_areas" ADD CONSTRAINT "team_member_service_areas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "rebook"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook"."team_member_service_areas" ADD CONSTRAINT "team_member_service_areas_team_member_fk" FOREIGN KEY ("tenant_id","team_member_id") REFERENCES "rebook"."team_members"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook"."team_members" ADD CONSTRAINT "team_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "rebook"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook"."working_hour_breaks" ADD CONSTRAINT "working_hour_breaks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "rebook"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook"."working_hour_breaks" ADD CONSTRAINT "working_hour_breaks_working_hours_fk" FOREIGN KEY ("tenant_id","working_hours_id") REFERENCES "rebook"."working_hours"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook"."working_hours" ADD CONSTRAINT "working_hours_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "rebook"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook"."working_hours" ADD CONSTRAINT "working_hours_team_member_fk" FOREIGN KEY ("tenant_id","team_member_id") REFERENCES "rebook"."team_members"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook"."working_hours" ADD CONSTRAINT "working_hours_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "rebook"."locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook"."custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "rebook"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook"."custom_field_values" ADD CONSTRAINT "custom_field_values_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "rebook"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook"."custom_field_values" ADD CONSTRAINT "custom_field_values_definition_fk" FOREIGN KEY ("tenant_id","definition_id","entity") REFERENCES "rebook"."custom_field_definitions"("tenant_id","id","entity") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook"."custom_field_values" ADD CONSTRAINT "custom_field_values_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "rebook"."services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "availability_exceptions_tenant_id_ends_at_idx" ON "rebook"."availability_exceptions" USING btree ("tenant_id","ends_at");--> statement-breakpoint
CREATE INDEX "availability_exceptions_tenant_id_team_member_id_idx" ON "rebook"."availability_exceptions" USING btree ("tenant_id","team_member_id");--> statement-breakpoint
CREATE INDEX "staff_services_tenant_id_service_id_idx" ON "rebook"."staff_services" USING btree ("tenant_id","service_id");--> statement-breakpoint
CREATE INDEX "working_hours_tenant_id_location_id_idx" ON "rebook"."working_hours" USING btree ("tenant_id","location_id");--> statement-breakpoint
CREATE INDEX "custom_field_values_tenant_id_service_id_idx" ON "rebook"."custom_field_values" USING btree ("tenant_id","service_id");