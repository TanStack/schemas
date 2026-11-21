CREATE TABLE `probe_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`raw_id` text NOT NULL,
	`route` text NOT NULL,
	`fact` text NOT NULL,
	`value` text,
	`status` integer NOT NULL,
	`message` text NOT NULL,
	`observed_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `probe_observations_provider_model_idx` ON `probe_observations` (`provider_id`,`raw_id`,`fact`);