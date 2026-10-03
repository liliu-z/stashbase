/** The provider stack a Fluid surface needs before any primitive will render
 *  the way it is designed to: reduced-motion honouring, the size ladder, the
 *  surface elevation the top level sits at, the icon set, and the tooltip
 *  group that shares one open delay. (The shape ladder needs no provider —
 *  see `lib/shape-context`.)
 *
 *  It lives here rather than in the app because three places mount the same
 *  stack — the running app, the Storybook canvas, and the test that scores
 *  every story for accessibility — and a surface rendered under a different
 *  stack is not the surface the product ships. The app adds its own outer
 *  concerns (StrictMode, the query client) around this; they are deliberately
 *  not here, because neither Storybook nor a component test wants them. */

'use client';

import { MotionConfig } from 'framer-motion';
import { type ReactNode } from 'react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { IconProvider } from '@/lib/icon-context';
import { SizeProvider, type SizeVariant } from '@/lib/size-context';
import { SurfaceProvider } from '@/lib/surface-context';
import { useAppliedAppearance } from '@/shared/runtime/appearance-surface';

interface FluidProvidersProps {
  /** The step every control inside starts on. Defaults to `default`. */
  size?: SizeVariant;
  children: ReactNode;
}

function FluidProviders({ size = 'default', children }: FluidProvidersProps) {
  // "user" follows the operating system; the Settings override forces it on.
  const reduceMotion = useAppliedAppearance()?.reduceMotion === 'on' ? 'always' : 'user';
  return (
    <MotionConfig reducedMotion={reduceMotion}>
      <SizeProvider size={size}>
        <SurfaceProvider value={1}>
          <IconProvider>
            <TooltipProvider>{children}</TooltipProvider>
          </IconProvider>
        </SurfaceProvider>
      </SizeProvider>
    </MotionConfig>
  );
}

export { FluidProviders };
