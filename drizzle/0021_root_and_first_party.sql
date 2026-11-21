-- Hand-written (issue #719): the sameAs chain root, the evidence for a
-- name-inferred link, and the provider's maker declaration. Nullable or
-- defaulted columns are added in place so the catalog is not copied
-- through a table rebuild; code that predates them never reads them.
ALTER TABLE `providers` ADD `makes_own_models` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `models` ADD `same_as_inference` text;
--> statement-breakpoint
ALTER TABLE `models` ADD `root_model_id` text
  REFERENCES `models` (`id`) ON DELETE set null
  CONSTRAINT `models_root_not_self` CHECK (`root_model_id` != `id`);
--> statement-breakpoint
CREATE INDEX `models_rootModelId_idx` ON `models` (`root_model_id`);
--> statement-breakpoint
CREATE INDEX `models_maker_providerId_idx` ON `models` (`maker`, `provider_id`);
