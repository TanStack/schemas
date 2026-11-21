ALTER TABLE `models` ADD `alias_of` text;--> statement-breakpoint
CREATE INDEX `models_providerId_rawId_idx` ON `models` (`provider_id`,`raw_id`);