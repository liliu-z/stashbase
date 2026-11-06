/** Bundled projects render before the network answers and remain usable offline. */
import type { GalleryEntry } from './entry';

export const GALLERY_SNAPSHOT: readonly GalleryEntry[] = [
  {
    about:
      'Post on LinkedIn consistently with a ghostwriter that learns your background, your work, and how you write. For developers, builders, and professionals who want to share what they\'re working on without spending an evening on every post.\n\n1. Set up: say "Set me up." and answer three quick questions. Paste a few past posts so it matches your style.\n\n2. Get ideas: say "I have an idea: …" to save your own. Or tell it about your day with "Today I …", and ask "What should I post?" to get ideas from your inbox and work notes.\n\n3. Write: say "Write about …" and it writes the post in your voice, with examples from your work, and asks for what\'s missing.\n\nA dashboard shows your ideas, drafts, and what you\'ve posted, with your inbox one click away.',
    category: 'personal brand',
    description: 'Turn an idea about your work into a LinkedIn post that sounds like you.',
    id: 'linkedin-ghostwriter',
    name: 'LinkedIn Ghostwriter',
    repo: 'https://github.com/stashbase-org/template-linkedin-ghostwriter',
    screenshot: null,
  },
  {
    about:
      'Turn the papers in your research area into a wiki, following Andrej Karpathy\'s LLM Wiki idea. For grad students and researchers who read a lot of papers in one area and want to see how they fit together.\n\n1. Set up: say "Set me up." and answer four quick questions about your area, your current work, and the papers you have. It builds a wiki from your papers.\n\n2. Add papers: drop PDFs into the library folder and say "Add the new papers.", or paste a link: "Add arxiv.org/abs/…". Each paper gets its own page, its connections to the others, and a place in the topic pages: who builds on whom, which results can be compared, where they disagree.\n\n3. Ask: "How do … and … compare?" The answer comes from the wiki, with sources. What you settle is kept: findings about the papers go back into the wiki, and your own ideas and drafts, like a related work section, go into your notes.\n\n4. Check: say "Check the wiki." every so often. It fixes conflicts and missing connections, and suggests the papers to add next.\n\nA dashboard shows your topics and how settled each one is, every paper with its main point and connections, what you\'re working on, and how the wiki has grown.',
    category: 'research',
    description:
      'See how the papers in your research area fit together, in a wiki that stays current as you add more.',
    id: 'llm-wiki-for-papers',
    name: 'LLM Wiki for Papers',
    repo: 'https://github.com/stashbase-org/template-llm-wiki-for-papers',
    screenshot: null,
  },
  {
    about:
      'Turn an idea into a short cartoon explainer video, starring a cartoon of you. For builders and creators who want to explain an idea on X or LinkedIn without filming, editing, or recording their voice.\n\n1. Set up: say "Set me up." and answer a few questions. Paste the included prompt into ChatGPT with a photo of you to get your character in 35 poses, then watch it move in a quick test.\n\n2. Make a video: say "Make a video about …". A script comes back first, with the parts, the headline of each, and what\'s on screen. Change anything you like.\n\n3. Watch it: say "Looks good." and the video is built, with the camera walking from page to page and moving in on the moments that matter.\n\n4. Export: say "Export it." to get an MP4, ready to post.',
    category: 'video',
    description: 'Turn an idea into a short cartoon explainer video, starring a cartoon of you.',
    id: 'cartoon-explainer-video',
    name: 'Cartoon Explainer Video',
    repo: 'https://github.com/stashbase-org/template-cartoon-explainer-video',
    screenshot: null,
  },
  {
    about:
      "Design the software you're about to build with an Agent that works as your software architect. For developers and tech leads who plan with AI first, then hand the build to Claude Code or Codex.\n\nTell it what the system does and who uses it. The Agent writes the architecture: modules, interfaces as code, key flows, and the decisions behind them. It applies SOLID where the code is likely to change, and tells you when something is over-engineered. As you talk, it updates the design each time you decide something, and saves a version before any big change. A dashboard draws the design as a diagram: click a module to see what it depends on, or switch versions to see what each decision added or changed.",
    category: 'engineering',
    description:
      'Talk through your software design and get an architecture a coding agent can build from, kept current as you change your mind.',
    id: 'software-architect',
    name: 'Software Architect',
    repo: 'https://github.com/stashbase-org/template-software-architect',
    screenshot: null,
  },
  {
    about:
      'Track your workouts with an Agent that coaches you. For beginners and anyone getting back into training, at home or at the gym, who want a plan that fits them and keeps up as they get stronger.\n\nTell the Agent your goal, your equipment, and how many days you can train. It writes your training rules and plans four weeks of workouts in a tracker: a calendar, monthly plans and reviews, and a weight chart. After a workout, tick it off or just tell the Agent how it went, and it keeps your notes. Each week it looks at what you finished and decides which exercises step up or back.',
    category: 'fitness',
    description:
      "Get a workout plan built for your goal and equipment, and let it change week by week with how you're actually doing.",
    id: 'workout-tracker',
    name: 'Workout Tracker',
    repo: 'https://github.com/stashbase-org/template-workout-tracker',
    screenshot: null,
  },
  {
    about:
      "Follow new AI research and see what it changes for your work. For analysts, investors, and other professionals who need to keep up with AI but don't do research for a living.\n\nTell the Agent what you do and which views you're tracking. It pulls the papers the AI community is paying attention to from Hugging Face Daily Papers, picks out the ones that support or challenge your views, and explains why in a short digest. Ask about a trend, a view, or a paper, and get an answer from your paper library, with sources.",
    category: 'research',
    description: 'Keep up with the AI papers that matter for your work, without reading them all.',
    id: 'paper-tracker-for-industry',
    name: 'Paper Tracker for Industry',
    repo: 'https://github.com/stashbase-org/template-paper-tracker-for-industry',
    screenshot: null,
  },
  {
    about:
      "Build your resume with an Agent that interviews you first. For students and early-career job seekers, whether it's your first resume or your old one undersells you.\n\nStart with your current resume or LinkedIn profile. The Agent asks about what's missing, like what you did yourself and what came of it, then writes a one-page resume from your answers. Paste a job description and it writes a version for that job, picking from everything you've told it, plus a cover letter if you need one.",
    category: 'career',
    description:
      'Build a resume that shows what you actually did, and tailor it to every job you apply for.',
    id: 'resume-builder',
    name: 'Resume Builder',
    repo: 'https://github.com/stashbase-org/template-resume-builder',
    screenshot: null,
  },
];
