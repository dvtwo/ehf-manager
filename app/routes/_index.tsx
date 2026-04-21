import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

export const loader = ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const params = url.searchParams.toString();
  return redirect(`/app${params ? `?${params}` : ""}`);
};
