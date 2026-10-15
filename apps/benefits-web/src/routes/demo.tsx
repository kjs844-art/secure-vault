import { Link, createFileRoute } from "@tanstack/react-router";
import { DemoExperience } from "../components/mvp-demo";

export const Route = createFileRoute("/demo")({
  // One serializable seed for server render and client hydration. No user data.
  loader: () => ({ referenceTime: Date.now() }),
  component: DemoPage,
});

function DemoPage() {
  const { referenceTime } = Route.useLoaderData();
  return (
    <main>
      <nav aria-label="데모 이동">
        <Link to="/">처음으로</Link>{" · "}<Link to="/status">연결 준비 상태</Link>
      </nav>
      <DemoExperience referenceTime={referenceTime} />
    </main>
  );
}
