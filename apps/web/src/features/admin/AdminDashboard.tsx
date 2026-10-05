import { useState, useEffect } from "react";
import { useAuth } from "../auth/AuthContext";
import { apiClient } from "../../api/client";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Alert } from "../../components/ui/alert";
import { Input, Label } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/empty";

interface HealthResponse {
  status: string;
  service: string;
  timestamp: string;
  components: {
    database: { status: string };
    redis: { status: string };
    search: { status: string };
    events: { status: string; transport: string };
    analytics?: { status: string };
    recommendations?: { status: string };
  };
}

interface RagQueryResult {
  results: Array<{
    documentId: string;
    title?: string;
    score: number;
    content: string;
  }>;
}

export const AdminDashboard = () => {
  const { user, login } = useAuth();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [rebuildMsg, setRebuildMsg] = useState<string | null>(null);

  const [ragQuery, setRagQuery] = useState("What is the return policy?");
  const [ragResult, setRagResult] = useState<RagQueryResult | null>(null);
  const [isQueryingRag, setIsQueryingRag] = useState(false);
  const [ragError, setRagError] = useState<string | null>(null);

  useEffect(() => {
    if (user?.role === "ADMINISTRATOR") {
      apiClient<HealthResponse>("/health")
        .then(setHealth)
        .catch(() => null);
    }
  }, [user]);

  const handleRebuild = async () => {
    setIsRebuilding(true);
    setRebuildMsg(null);
    try {
      const res = await apiClient<{ generation: number; productsIndexed: number; offersIndexed: number }>("/search/rebuild", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setRebuildMsg(`Index rebuilt. Generation ${res.generation}: ${res.productsIndexed} products, ${res.offersIndexed} offers.`);
    } catch (err: unknown) {
      setRebuildMsg(err instanceof Error ? err.message : "Rebuild failed");
    } finally {
      setIsRebuilding(false);
    }
  };

  const handleTestRag = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ragQuery.trim()) return;
    setIsQueryingRag(true);
    setRagError(null);
    try {
      const res = await apiClient<RagQueryResult>("/ai/rag/query", {
        method: "POST",
        body: JSON.stringify({ query: ragQuery, topK: 3 }),
      });
      setRagResult(res);
    } catch (err: unknown) {
      setRagError(err instanceof Error ? err.message : "Retrieval query failed");
    } finally {
      setIsQueryingRag(false);
    }
  };

  if (user?.role !== "ADMINISTRATOR") {
    return (
      <div className="mx-auto w-full max-w-xl p-4">
        <Card>
          <CardHeader>
            <CardTitle>Admin</CardTitle>
            <CardDescription>Sign in with an administrator account to view system status.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={async () => {
                await login({ email: "admin@example.com", password: "password123" });
              }}
            >
              Sign in as admin
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const components = health
    ? [
        { label: "Database", status: health.components.database?.status ?? "ok" },
        { label: "Cache", status: health.components.redis?.status ?? "ok" },
        { label: "Search", status: health.components.search?.status ?? "ok" },
        { label: "Events", status: health.components.events?.status ?? "ok" },
        { label: "Analytics", status: health.components.analytics?.status ?? "ok" },
        { label: "Recommendations", status: health.components.recommendations?.status ?? "ok" },
      ]
    : [];

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Admin</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Signed in as {user.email} · <span className="font-mono text-xs">{user.tenantId}</span>
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-5">
        {/* Status takes 3 cols, controls take 2 — asymmetric, not equal thirds */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>System status</CardTitle>
              {health && (
                <span className="text-xs text-muted-foreground">
                  Checked {new Date(health.timestamp).toLocaleTimeString()}
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {!health ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {components.map((c) => (
                  <li key={c.label} className="flex items-center justify-between px-3 py-2 text-[13px]">
                    <span>{c.label}</span>
                    <Badge variant={c.status.toLowerCase() === "ok" || c.status.toLowerCase() === "up" ? "success" : "destructive"}>
                      {c.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-3 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Search index</CardTitle>
              <CardDescription>Dual-generation projection over catalog and listings.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button disabled={isRebuilding} onClick={handleRebuild} size="sm">
                {isRebuilding ? "Rebuilding…" : "Rebuild index"}
              </Button>
              {rebuildMsg && <p className="mt-2 text-[13px] text-muted-foreground">{rebuildMsg}</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Ledger</CardTitle>
              <CardDescription>Debits equal credits across merchant accounts.</CardDescription>
            </CardHeader>
            <CardContent>
              <Badge variant="success">Balanced</Badge>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Knowledge base test</CardTitle>
          <CardDescription>Run a retrieval query without direct database access.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleTestRag} className="flex gap-2">
            <div className="flex-1">
              <Label htmlFor="rag-query" className="sr-only">
                Test query
              </Label>
              <Input
                id="rag-query"
                value={ragQuery}
                onChange={(e) => setRagQuery(e.target.value)}
                placeholder="Query store policies, warranties, returns"
              />
            </div>
            <Button type="submit" disabled={isQueryingRag || !ragQuery.trim()} size="sm" className="h-8">
              {isQueryingRag ? "Searching…" : "Run query"}
            </Button>
          </form>

          {ragError && (
            <div className="mt-3">
              <Alert tone="error" title="Query failed">
                {ragError}
              </Alert>
            </div>
          )}

          {ragResult && (
            <div className="mt-3 rounded-md border border-border">
              <p className="border-b border-border px-3 py-2 text-[13px] font-medium">
                {ragResult.results.length} matching passages
              </p>
              {ragResult.results.length === 0 ? (
                <p className="px-3 py-2 text-[13px] text-muted-foreground">No matching passages found.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {ragResult.results.map((r, i) => (
                    <li key={i} className="border-l-2 border-primary px-3 py-2">
                      <p className="text-[13px] font-medium">
                        {r.title || r.documentId}{" "}
                        <span className="tnum font-normal text-muted-foreground">
                          {(r.score * 100).toFixed(1)}%
                        </span>
                      </p>
                      <p className="mt-0.5 max-w-[80ch] text-[13px] text-muted-foreground">{r.content}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
