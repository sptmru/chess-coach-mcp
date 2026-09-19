CREATE TABLE "analysis_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"engine_version" text NOT NULL,
	"algorithm_version" text NOT NULL,
	"config" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "analysis_runs_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
CREATE TABLE "sync_archives" (
	"player_id" uuid NOT NULL,
	"url" text NOT NULL,
	"etag" text,
	"last_modified" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_archives_player_id_url_pk" PRIMARY KEY("player_id","url")
);
--> statement-breakpoint
CREATE TABLE "training_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"exercise_id" uuid NOT NULL,
	"exercise_version" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"result" text NOT NULL,
	"time_spent" real,
	"attempted_move" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attempt_result" CHECK ("training_attempts"."result" in ('solved','failed','partial'))
);
--> statement-breakpoint
CREATE TABLE "semantic_classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"taxonomy_version" text NOT NULL,
	"schema_version" text NOT NULL,
	"primary_label" text,
	"secondary_labels" jsonb,
	"confidence" real,
	"normalized" jsonb,
	"raw" jsonb,
	"latency_ms" integer,
	"usage" jsonb,
	"cost" real,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "critical_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"color" text NOT NULL,
	"ply" integer NOT NULL,
	"severity" real NOT NULL,
	"group" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_exercises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"version" text NOT NULL,
	"fen" text NOT NULL,
	"side_to_move" text NOT NULL,
	"difficulty" text NOT NULL,
	"solution" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_focuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"focus" text NOT NULL,
	"reason" text NOT NULL,
	"target_pattern" text,
	"duration_games" integer,
	"review_date" timestamp with time zone,
	"state" text DEFAULT 'started' NOT NULL,
	"baseline" jsonb NOT NULL,
	"end_metrics" jsonb,
	"changes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL,
	"upstream_id" text,
	"url" text,
	"white" text NOT NULL,
	"black" text NOT NULL,
	"white_rating" integer,
	"black_rating" integer,
	"result" text NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"time_control" text NOT NULL,
	"time_class" text NOT NULL,
	"rated" boolean NOT NULL,
	"termination" text,
	"eco" text,
	"opening" text,
	"variation" text,
	"theory_exit_ply" integer,
	"opening_source" text,
	"pgn" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "games_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"goal" text NOT NULL,
	"target_rating" integer,
	"target_date" timestamp with time zone,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_chess_players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chess_player_id" uuid NOT NULL,
	"provider" text DEFAULT 'chesscom' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_unverified" CHECK ("user_chess_players"."verified" = false)
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"type" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"total" integer DEFAULT 0 NOT NULL,
	"completed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"retries" integer DEFAULT 0 NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"error" text,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "move_analyses" (
	"run_id" uuid NOT NULL,
	"ply" integer NOT NULL,
	"color" text NOT NULL,
	"cpl" real,
	"phase" text NOT NULL,
	"severity" real NOT NULL,
	"facts" jsonb NOT NULL,
	CONSTRAINT "move_analyses_run_id_ply_pk" PRIMARY KEY("run_id","ply")
);
--> statement-breakpoint
CREATE TABLE "moves" (
	"game_id" uuid NOT NULL,
	"ply" integer NOT NULL,
	"color" text NOT NULL,
	"san" text NOT NULL,
	"uci" text NOT NULL,
	"fen_before" text NOT NULL,
	"fen_after" text NOT NULL,
	"clock_before" real,
	"clock_after" real,
	"think_time" real,
	"phase" text NOT NULL,
	"move_number" integer NOT NULL,
	CONSTRAINT "moves_game_id_ply_pk" PRIMARY KEY("game_id","ply")
);
--> statement-breakpoint
CREATE TABLE "coaching_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"note" text NOT NULL,
	"category" text,
	"related_pattern" text,
	"review_after_games" integer,
	"baseline_games" integer NOT NULL,
	"review_after_date" timestamp with time zone,
	"source" text DEFAULT 'mcp_client' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"challenge" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"csrf_hash" text NOT NULL,
	"params" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"hash" text PRIMARY KEY NOT NULL,
	"family" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"kind" text NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mistake_patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"type" text NOT NULL,
	"analysis_key" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_games" (
	"player_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"color" text NOT NULL,
	CONSTRAINT "player_games_player_id_game_id_pk" PRIMARY KEY("player_id","game_id"),
	CONSTRAINT "player_game_color" CHECK ("player_games"."color" in ('w','b'))
);
--> statement-breakpoint
CREATE TABLE "chess_players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upstream_id" text NOT NULL,
	"username" text NOT NULL,
	"profile" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chess_players_upstream_id_unique" UNIQUE("upstream_id"),
	CONSTRAINT "chess_players_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "coaching_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"repertoire" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_set_exercises" (
	"set_id" uuid NOT NULL,
	"exercise_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "training_set_exercises_set_id_exercise_id_pk" PRIMARY KEY("set_id","exercise_id")
);
--> statement-breakpoint
CREATE TABLE "training_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"theme" text,
	"criteria" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_archives" ADD CONSTRAINT "sync_archives_player_id_chess_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."chess_players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_attempts" ADD CONSTRAINT "training_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_attempts" ADD CONSTRAINT "training_attempts_identity_id_user_chess_players_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."user_chess_players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_attempts" ADD CONSTRAINT "training_attempts_exercise_id_training_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."training_exercises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_classifications" ADD CONSTRAINT "semantic_classifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_classifications" ADD CONSTRAINT "semantic_classifications_identity_id_user_chess_players_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."user_chess_players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_classifications" ADD CONSTRAINT "semantic_classifications_position_id_critical_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."critical_positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "critical_positions" ADD CONSTRAINT "critical_positions_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "critical_positions" ADD CONSTRAINT "critical_positions_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_exercises" ADD CONSTRAINT "training_exercises_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_exercises" ADD CONSTRAINT "training_exercises_identity_id_user_chess_players_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."user_chess_players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_exercises" ADD CONSTRAINT "training_exercises_position_id_critical_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."critical_positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_focuses" ADD CONSTRAINT "training_focuses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_focuses" ADD CONSTRAINT "training_focuses_identity_id_user_chess_players_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."user_chess_players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_identity_id_user_chess_players_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."user_chess_players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_chess_players" ADD CONSTRAINT "user_chess_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_chess_players" ADD CONSTRAINT "user_chess_players_chess_player_id_chess_players_id_fk" FOREIGN KEY ("chess_player_id") REFERENCES "public"."chess_players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_identity_id_user_chess_players_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."user_chess_players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_analyses" ADD CONSTRAINT "move_analyses_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moves" ADD CONSTRAINT "moves_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_notes" ADD CONSTRAINT "coaching_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_notes" ADD CONSTRAINT "coaching_notes_identity_id_user_chess_players_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."user_chess_players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mistake_patterns" ADD CONSTRAINT "mistake_patterns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mistake_patterns" ADD CONSTRAINT "mistake_patterns_identity_id_user_chess_players_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."user_chess_players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_games" ADD CONSTRAINT "player_games_player_id_chess_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."chess_players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_games" ADD CONSTRAINT "player_games_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_profiles" ADD CONSTRAINT "coaching_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_profiles" ADD CONSTRAINT "coaching_profiles_identity_id_user_chess_players_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."user_chess_players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_set_exercises" ADD CONSTRAINT "training_set_exercises_set_id_training_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."training_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_set_exercises" ADD CONSTRAINT "training_set_exercises_exercise_id_training_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."training_exercises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_sets" ADD CONSTRAINT "training_sets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_sets" ADD CONSTRAINT "training_sets_identity_id_user_chess_players_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."user_chess_players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_game_status" ON "analysis_runs" USING btree ("game_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "attempt_idempotency" ON "training_attempts" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "classification_cache" ON "semantic_classifications" USING btree ("user_id","identity_id","fingerprint");--> statement-breakpoint
CREATE INDEX "classification_owner" ON "semantic_classifications" USING btree ("user_id","identity_id","primary_label");--> statement-breakpoint
CREATE UNIQUE INDEX "critical_run_ply" ON "critical_positions" USING btree ("run_id","ply");--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_owner_version" ON "training_exercises" USING btree ("user_id","identity_id","position_id","version");--> statement-breakpoint
CREATE INDEX "games_date" ON "games" USING btree ("ended_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_user_player" ON "user_chess_players" USING btree ("user_id","chess_player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_one_primary" ON "user_chess_players" USING btree ("user_id") WHERE "user_chess_players"."is_primary";--> statement-breakpoint
CREATE UNIQUE INDEX "job_idempotency" ON "jobs" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "job_state_created" ON "jobs" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "token_family" ON "oauth_tokens" USING btree ("family");--> statement-breakpoint
CREATE UNIQUE INDEX "pattern_owner_type" ON "mistake_patterns" USING btree ("user_id","identity_id","type","analysis_key");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_owner" ON "coaching_profiles" USING btree ("user_id","identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "set_ordinal" ON "training_set_exercises" USING btree ("set_id","ordinal");