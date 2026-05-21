import { redirect } from "next/navigation";

export default function RecordsSchedulesRedirect() {
  redirect("/dashboard/schedules");
}
