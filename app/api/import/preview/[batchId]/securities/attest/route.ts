import { attestSecurityCandidateAction } from "../../../../../../import-actions";
import { createSecurityAttestPost } from "../../../../../../security-attestation-route";

export const POST = createSecurityAttestPost(attestSecurityCandidateAction);
