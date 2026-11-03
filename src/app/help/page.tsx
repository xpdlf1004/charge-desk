import { SiteTop } from "../../components/SiteTop.tsx";
import { HelpDesk } from "./HelpDesk.tsx";

export const metadata = { title: "Payment help · Brightleaf Studio" };

export default async function HelpPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const { from } = await searchParams;
  return (
    <>
      <SiteTop current="help" />
      <HelpDesk fromReceipt={from === "receipt"} />
    </>
  );
}
