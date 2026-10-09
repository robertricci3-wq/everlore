export interface PublicArtwork {
  id: string;
  src: string;
  width: number;
  height: number;
  title: string;
  caption: string;
  alt: string;
}

// Deliberately independent of private projects, sources and saved editions.
// Only the three specifically approved illustrations belong in this showcase.
export const PUBLIC_ART_SHOWCASE = {
  version: 1,
  id: "animal-stories-v1",
  heading: "A little truth. A world of wonder.",
  description:
    "Your family, reimagined as storybook animals. Your memories, made extraordinary.",
  attribution:
    "Illustrations from an Everlore family story, shared with permission.",
  heroId: "connection",
  artworks: [
    {
      id: "invitation",
      src: "/images/showcase/invitation-v1.webp",
      width: 1024,
      height: 1024,
      title: "A door opens",
      caption: "A small gesture. A world of possibility.",
      alt: "A fox holds open a wooden door for a crane and a rabbit. Beyond them, warm lamplight fills a winding world of rooms.",
    },
    {
      id: "connection",
      src: "/images/showcase/connection-v1.webp",
      width: 1024,
      height: 1024,
      title: "A moment of connection",
      caption: "Personality in a glance, a gesture, a shared moment.",
      alt: "A fox in a green jacket and golden scarf turns toward a crane in a blue coat on a lamplit cobblestone street.",
    },
    {
      id: "remembering",
      src: "/images/showcase/remembering-v1.webp",
      width: 1024,
      height: 1024,
      title: "A memory takes flight",
      caption: "The everyday opens into something extraordinary.",
      alt: "A fox holds a warm cup while curling steam reveals small scenes of animal friends together in glowing rooms.",
    },
  ] satisfies PublicArtwork[],
} as const;

export const PUBLIC_HERO_ARTWORK = PUBLIC_ART_SHOWCASE.artworks.find(
  (artwork) => artwork.id === PUBLIC_ART_SHOWCASE.heroId,
)!;
