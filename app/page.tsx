import { PortfolioShell } from "./components/portfolio-shell";
import { loadAuthenticatedWorkspace } from "./authenticated-workspace";

export default async function Home() {
  const workspace = await loadAuthenticatedWorkspace();
  return <PortfolioShell activeSection="overview" ownedWorkspace={workspace} />;
}
