# Deferred items

## Claude transcript workspace provenance

Claude Code maps canonical workspace paths to session directories by replacing every non-alphanumeric
character with `-`. Distinct paths can therefore share a directory, while T3's importer currently does
not validate record-level transcript `cwd` before listing or reading a session. This is a real pre-existing
correctness and local data-isolation risk, but fixing it safely requires a compatibility decision for
older transcripts and sessions whose workspace moved, so it is deferred from the narrow title-preservation
change.
