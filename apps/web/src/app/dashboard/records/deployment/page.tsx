import { redirect } from "next/navigation";

export default function RecordsDeploymentRedirect() {
  redirect("/dashboard/deployment");
}
