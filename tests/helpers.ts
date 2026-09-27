import { openDb } from "@/lib/db";
import { createBusiness } from "@/lib/repos/businesses";

export function freshDb() {
  const db = openDb(":memory:");
  const a = createBusiness(db, { name: "세무사무소", kind: "세무", color: "#0ea5e9", currency: "KRW" });
  const b = createBusiness(db, { name: "SaaS", kind: "소프트웨어", color: "#f97316", currency: "USD" });
  return { db, a, b };
}
