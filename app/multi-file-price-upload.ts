// MKT-018C: sequential multi-file price-CSV upload orchestration for the
// "Historical Data" section's per-security importer (the owner now selects
// several Intelligent Investor exports at once via the MKT-018B guided
// panel's downloads and wants to "upload them all in one go").
//
// This module is deliberately DOM-free and framework-free (a plain `.ts`
// module importable under Node's `--experimental-strip-types` loader,
// mirroring `app/price-history-coverage-format.ts`'s split from its "use
// client" `.tsx` consumer) so the sequencing/error-isolation/ordering logic
// is directly unit-testable with fake `previewFile`/`confirmFile`/`decide`
// implementations -- no fetch, no DOM `File`, no interactive render harness
// (this codebase has none, see `tests/brk-005b.test.ts`'s header note).
//
// Ruling this encodes (TASKS.md MKT-018C): each file runs through the
// EXISTING per-file preview/confirm pipeline UNCHANGED -- this module never
// parses a CSV or writes a row itself, it only sequences calls into
// `previewFile`/`confirmFile` (which the caller wires to the real
// `/api/market-data/price-uploads/preview` and `.../confirm` endpoints, the
// same ones `previewSingle`/`confirmSingle` already call for the one-file
// case). One file's failure is recorded and the loop continues to the next
// file -- it never aborts the run. The owner reviews each file's preview in
// order via the injected `decide` callback (never auto-confirmed), matching
// the existing preview-then-confirm semantics for a single file; `decide`
// resolving "cancel" stops the run without touching files not yet reached.
export type MultiFilePreviewResult<TPreview> =
  { ok: true; preview: TPreview } | { ok: false; message: string };

export type MultiFileConfirmResult =
  | { ok: true; written: number; insertedRowCount: number }
  | { ok: false; message: string };

export type MultiFileDecision = "confirm" | "skip" | "cancel";

export type MultiFileStepStatus = "committed" | "skipped" | "error";

export type MultiFileStepResult = Readonly<{
  filename: string;
  status: MultiFileStepStatus;
  message: string;
}>;

export type MultiFileUploadDeps<TFile, TPreview> = Readonly<{
  previewFile: (file: TFile) => Promise<MultiFilePreviewResult<TPreview>>;
  confirmFile: (file: TFile) => Promise<MultiFileConfirmResult>;
  /** Never auto-confirmed -- resolves once the owner has reviewed this
   * file's preview and chosen confirm/skip/cancel. */
  decide: (
    preview: TPreview,
    index: number,
    total: number,
  ) => Promise<MultiFileDecision>;
  onProgress?: (index: number, total: number, filename: string) => void;
  filenameOf: (file: TFile) => string;
}>;

export type MultiFileUploadOutcome = Readonly<{
  results: MultiFileStepResult[];
  /** True only when the owner chose "cancel" partway through -- files at
   * and after the cancelled index simply have no entry in `results` (never
   * processed), rather than being reported as skipped/failed. */
  cancelled: boolean;
}>;

export async function runMultiFilePriceUpload<TFile, TPreview>(
  files: readonly TFile[],
  deps: MultiFileUploadDeps<TFile, TPreview>,
): Promise<MultiFileUploadOutcome> {
  const results: MultiFileStepResult[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]!;
    const filename = deps.filenameOf(file);
    const index = i + 1;
    deps.onProgress?.(index, files.length, filename);

    const previewResult = await deps.previewFile(file);
    if (!previewResult.ok) {
      results.push({
        filename,
        status: "error",
        message: `Failed: ${previewResult.message}`,
      });
      continue;
    }

    const decision = await deps.decide(
      previewResult.preview,
      index,
      files.length,
    );
    if (decision === "cancel") {
      return { results, cancelled: true };
    }
    if (decision === "skip") {
      results.push({
        filename,
        status: "skipped",
        message: "Skipped — not imported.",
      });
      continue;
    }

    const confirmResult = await deps.confirmFile(file);
    if (!confirmResult.ok) {
      results.push({
        filename,
        status: "error",
        message: `Failed: ${confirmResult.message}`,
      });
      continue;
    }
    const overlaid = confirmResult.written - confirmResult.insertedRowCount;
    results.push({
      filename,
      status: "committed",
      message: `Imported ${confirmResult.written} price observation${
        confirmResult.written === 1 ? "" : "s"
      } (${confirmResult.insertedRowCount} newly created, ${overlaid} overlaid existing).`,
    });
  }
  return { results, cancelled: false };
}
