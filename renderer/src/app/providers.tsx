import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useEffect, useState, type PropsWithChildren } from 'react';

import { listenForRendererErrors, type ErrorReporter } from '@/platform/error-reporting';
import { ErrorReportingProvider } from '@/shared/runtime/error-reporting';
import { FluidProviders } from '@/shared/runtime/fluid-providers';

/** The app's outer concerns — StrictMode and the query client — wrapped around
 *  the same Fluid stack Storybook and the component tests mount, so a surface
 *  in the running app is the surface those two prove. */
export function Providers({
  children,
  reportError,
}: PropsWithChildren<{ reportError?: ErrorReporter | undefined }>) {
  useEffect(() => (reportError ? listenForRendererErrors(reportError) : undefined), [reportError]);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { refetchOnWindowFocus: false },
        },
      }),
  );
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ErrorReportingProvider report={reportError}>
          <FluidProviders>{children}</FluidProviders>
        </ErrorReportingProvider>
      </QueryClientProvider>
    </StrictMode>
  );
}
