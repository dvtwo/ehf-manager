import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // authenticate.admin throws a redirect on OAuth callback — if it returns
  // normally (e.g. already authenticated), forward to the app.
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "";
  const host = url.searchParams.get("host") ?? "";
  const params = new URLSearchParams();
  if (shop) params.set("shop", shop);
  if (host) params.set("host", host);
  const qs = params.toString();
  return redirect(`/app${qs ? `?${qs}` : ""}`);
};
