import { updateImportSecurityMetadataAction } from "../../../../../../import-actions";
import { createImportSecurityMetadataPost } from "../../../../../../import-security-metadata-route";

export const POST = createImportSecurityMetadataPost(
  updateImportSecurityMetadataAction,
);
