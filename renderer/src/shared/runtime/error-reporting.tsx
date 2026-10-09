import { createContext, useContext, type PropsWithChildren } from 'react';

export type ErrorReporter = (error: unknown, operation: string) => void;
const ErrorReportingContext = createContext<ErrorReporter | undefined>(undefined);

/** The app supplies delivery; viewers can report a caught failure without
 * knowing the host, privacy preference, or telemetry protocol. */
export function ErrorReportingProvider({
  children,
  report,
}: PropsWithChildren<{ report?: ErrorReporter | undefined }>) {
  return <ErrorReportingContext value={report}>{children}</ErrorReportingContext>;
}

export function useErrorReporter(): ErrorReporter | undefined {
  return useContext(ErrorReportingContext);
}
