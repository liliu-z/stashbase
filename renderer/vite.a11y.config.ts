import config from './vite.config';

export default {
  ...config,
  test: {
    ...config.test,
    // Accessibility reads computed visibility; behavior tests need no CSS cascade.
    css: true,
    include: ['src/stories.a11y.test.tsx'],
  },
};
