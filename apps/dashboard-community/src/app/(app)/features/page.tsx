import { FeatureMatrix, type Capability } from "@/components/operate/feature-matrix";
import { PageHeader } from "@/components/page-header";
import manifest from "@/generated/capabilities.json";
import { selfTestHistory } from "@/lib/server/selftest";
import { requireViewer } from "@/lib/server/session";

export const metadata = { title: "Feature matrix" };

export default async function FeaturesPage() {
  await requireViewer();
  const history = await selfTestHistory();
  return (
    <>
      <PageHeader
        title="Feature matrix"
        description={`Firecrawl Cloud versus this Community deployment, from community/capabilities.yml (evidence: ${manifest.evidence.communityRelease}). Self-tests send a small real request with your key and are billed to you.`}
      />
      <FeatureMatrix
        capabilities={manifest.capabilities as Capability[]}
        statusDefinitions={manifest.statusDefinitions as Record<string, string>}
        history={history}
      />
    </>
  );
}
