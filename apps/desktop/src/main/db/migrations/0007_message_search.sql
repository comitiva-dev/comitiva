-- Phase 7: full-text search over messages (SQLite FTS5, bundled with
-- better-sqlite3). Drizzle cannot model a virtual table, so this one lives
-- only here: it is not in schema.ts or the snapshots.
--
-- One row per finished message, keyed by the message's rowid: the text of its
-- text blocks plus the names of its attachments (tool calls are not indexed).
-- Diacritics fold (`remove_diacritics 2`), so "relatorio" finds "relatório".
-- Triggers keep it in sync. A reply is indexed when it stops streaming; its
-- 250 ms checkpoints (streaming → streaming) never touch the index.
CREATE VIRTUAL TABLE `messages_fts` USING fts5(
  `text`,
  `message_id` UNINDEXED,
  `conversation_id` UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `messages_fts_insert` AFTER INSERT ON `messages`
WHEN NEW.`status` <> 'streaming'
BEGIN
  INSERT INTO `messages_fts` (`rowid`, `text`, `message_id`, `conversation_id`)
  SELECT NEW.`rowid`, group_concat(t, char(10)), NEW.`id`, NEW.`conversation_id`
    FROM (SELECT CASE json_extract(value, '$.type')
                   WHEN 'text' THEN json_extract(value, '$.text')
                   WHEN 'document' THEN json_extract(value, '$.name')
                   WHEN 'image' THEN json_extract(value, '$.name')
                 END AS t
            FROM json_each(NEW.`content`))
   WHERE t IS NOT NULL AND t <> ''
  HAVING count(*) > 0;
END;
--> statement-breakpoint
CREATE TRIGGER `messages_fts_update` AFTER UPDATE OF `content`, `status` ON `messages`
WHEN NEW.`status` <> 'streaming' OR OLD.`status` <> 'streaming'
BEGIN
  DELETE FROM `messages_fts` WHERE `rowid` = OLD.`rowid`;
  INSERT INTO `messages_fts` (`rowid`, `text`, `message_id`, `conversation_id`)
  SELECT NEW.`rowid`, group_concat(t, char(10)), NEW.`id`, NEW.`conversation_id`
    FROM (SELECT CASE json_extract(value, '$.type')
                   WHEN 'text' THEN json_extract(value, '$.text')
                   WHEN 'document' THEN json_extract(value, '$.name')
                   WHEN 'image' THEN json_extract(value, '$.name')
                 END AS t
            FROM json_each(NEW.`content`))
   WHERE NEW.`status` <> 'streaming' AND t IS NOT NULL AND t <> ''
  HAVING count(*) > 0;
END;
--> statement-breakpoint
CREATE TRIGGER `messages_fts_delete` AFTER DELETE ON `messages`
BEGIN
  DELETE FROM `messages_fts` WHERE `rowid` = OLD.`rowid`;
END;
--> statement-breakpoint
INSERT INTO `messages_fts` (`rowid`, `text`, `message_id`, `conversation_id`)
SELECT m.`rowid`, group_concat(t, char(10)), m.`id`, m.`conversation_id`
  FROM (SELECT m.`rowid`, m.`id`, m.`conversation_id`,
               CASE json_extract(j.value, '$.type')
                 WHEN 'text' THEN json_extract(j.value, '$.text')
                 WHEN 'document' THEN json_extract(j.value, '$.name')
                 WHEN 'image' THEN json_extract(j.value, '$.name')
               END AS t
          FROM `messages` m, json_each(m.`content`) j
         WHERE m.`status` <> 'streaming') m
 WHERE t IS NOT NULL AND t <> ''
 GROUP BY m.`rowid`;
