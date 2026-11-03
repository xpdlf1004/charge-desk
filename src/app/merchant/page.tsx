import { SiteTop } from "../../components/SiteTop.tsx";
import { Dashboard } from "./Dashboard.tsx";

export const metadata = { title: "Studio dashboard · Brightleaf Studio" };

export default function MerchantPage() {
  return (
    <>
      <SiteTop current="merchant" />
      <Dashboard />
    </>
  );
}
