import { notFound } from "next/navigation";

import { AdminPreview } from "./preview";

/**
 * DEVELOPMENT ONLY (404 in production): the admin forms with fake data, to look at the layout without
 * signing in. /dev/admin?view=limits | retention | system | health | expiry
 */
export default async function DevAdmin({ searchParams }: PageProps<"/dev/admin">) {
  if (process.env.NODE_ENV === "production") notFound();
  const view = (await searchParams).view;
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-7 sm:px-9">
      <AdminPreview view={typeof view === "string" ? view : "limits"} />
    </main>
  );
}
