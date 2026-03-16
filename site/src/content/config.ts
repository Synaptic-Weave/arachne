import { defineCollection, z } from 'astro:content';

const docs = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    order: z.number().default(99),
  }),
});

const developers = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    order: z.number().default(99),
  }),
});

const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    date: z.date(),
    author: z.string(),
    description: z.string(),
    tags: z.array(z.string()).default([]),
  }),
});

const devblog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    date: z.date(),
    author: z.string(),
    description: z.string(),
    tags: z.array(z.string()).default([]),
    series: z.string().optional(),
    agentRole: z.string().optional(),
  }),
});

export const collections = { docs, developers, blog, devblog };
