import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// Shopify loads the app at the root URL (application_url = https://ehf-manager.onrender.com).
// We authenticate here so token exchange completes, then forward to /app.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const params = url.searchParams.toString();
  return redirect(`/app${params ? `?${params}` : ""}`);
};
