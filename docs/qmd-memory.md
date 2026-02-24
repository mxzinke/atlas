# QMD Memory and Search

QMD (Query Markdown) is the memory search daemon that indexes all Markdown files in `workspace/memory/` and provides BM25, vector, and hybrid search via HTTP MCP.

## Architecture

QMD runs as an HTTP MCP server on port 8181. It automatically indexes:

- `workspace/memory/MEMORY.md` — Long-term persistent knowledge
- `workspace/memory/YYYY-MM-DD.md` — Daily journal entries
- `workspace/memory/projects/*.md` — Project-specific notes
- `workspace/memory/**/*.md` — Any other Markdown files

Files are indexed automatically when written or modified.

## Search Modes

Configured via `config.yml` (`memory.qmd_search_mode`):

| Mode | Description | Use Case |
|------|-------------|----------|
| `search` | BM25 text search | Keyword matching, exact phrases |
| `vsearch` | Vector/semantic search | Conceptual similarity |
| `query` | Hybrid (BM25 + vector) | Best overall results |

## Tool Specifications

### qmd_search

BM25 text search for keyword matching.

```typescript
{
  query: string,       // Search terms
  limit?: number       // Max results (default: from config)
}
```

Returns matching documents with relevance scores.

### qmd_vector_search

Semantic vector search for conceptual similarity.

```typescript
{
  query: string,       // Natural language query
  limit?: number       // Max results
}
```

Returns semantically similar documents based on embeddings.

### qmd_deep_search

Combined hybrid search (BM25 + vector with reciprocal rank fusion).

```typescript
{
  query: string,       // Search terms or question
  limit?: number       // Max results
}
```

Returns best results from both methods, deduplicated and reranked.

### qmd_get

Get a specific document by path.

```typescript
{
  path: string         // Relative path in workspace/memory/
}
```

### qmd_multi_get

Get multiple documents at once.

```typescript
{
  paths: string[]      // Array of relative paths
}
```

### qmd_status

Get indexing status: number of documents indexed, last update time.

## Memory Organization

### MEMORY.md

Long-term, timeless knowledge:
- User preferences and facts
- Project architectures and decisions
- API keys and config locations
- Procedures and workflows

### Daily Journals (YYYY-MM-DD.md)

Daily activity log, append-only:
- Tasks completed
- Conversations had
- Decisions made
- Context for that day

### Project Notes (projects/*.md)

Topic-specific knowledge:
- Detailed project documentation
- Research findings
- Technical specifications

## Configuration

```yaml
memory:
  qmd_search_mode: search      # search | vsearch | query
  qmd_max_results: 6
  load_memory_md: true         # Load full MEMORY.md on start
  load_journal_days: 2         # Load recent journal entries
```

## Usage in Prompts

Claude uses QMD automatically via tools:

```
"What did we decide about the auth system last week?"
→ qmd_deep_search("auth system decision")
→ Found in 2026-02-20.md: "Decided to use JWT with refresh tokens..."
```

## Source

QMD is typically a separate binary or MCP server. Configuration and integration are in:
- `app/defaults/config.yml` — Search settings
- Inbox-MCP provides tools that call QMD HTTP endpoints
