import { verifySecurityCandidateAction } from "../../../../../../import-actions";
import { createSecurityVerifyPost } from "../../../../../../security-verification-route";

export const POST = createSecurityVerifyPost(verifySecurityCandidateAction);
