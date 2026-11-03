import { createContext, useContext, type PropsWithChildren } from 'react';

export type ErrorReporter = (
  error: unknown,
  operation: string,
  context?: {
    action?: string;
    method?: string;
    route?: string;
    reason?: string;
    elapsed_ms?: number;
    turn_id?: string | undefined;
    connection_id?: string;
    close_code?: number;
    was_clean?: boolean;
    close_initiator?: 'client' | 'server' | 'unknown';
  },
) => void;
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
