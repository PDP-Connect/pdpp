import { redirect } from "next/navigation";

// The operator console root is just a pointer at /dashboard. The standards
// site lives in apps/site; visitors that land on the bare console origin
// should go straight to the dashboard. See openspec/changes/split-public-site-and-operator-console.
export default function ConsoleRoot() {
  redirect("/dashboard");
}
