import {
  describeBlockedDomainWebhook,
  handleBlockedDomainWebhook,
} from "@/lib/blocked-domains/webhook";

export const dynamic = "force-dynamic";

// Both the singular and plural spellings are mounted, because everything else
// in the app is plural and a one-character miss returns an opaque 404.
export const POST = handleBlockedDomainWebhook;
export const GET = describeBlockedDomainWebhook;
