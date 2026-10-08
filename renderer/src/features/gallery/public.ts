/**
 * The Gallery feature's whole surface to `renderer/src/app`.
 *
 * The shop is composed rather than routed: the band is a slot the bare
 * window's welcome screen renders, and the overlay is opened by the workspace
 * sidebar. Both take the same entries and the same open handler, so there is
 * one shop with two frames rather than two shops.
 */
export type { GalleryIndex, GalleryPort } from './application/ports';
export type { GalleryEntry } from './domain/entry';
export type { GalleryPersona } from './domain/persona';
export { createGalleryIndexAdapter } from './infrastructure/gallery-api';
export { useGallery } from './hooks/use-gallery';
export { GalleryOverlay, type GallerySection } from './ui/overlay';
export { GalleryShop } from './ui/shop';
