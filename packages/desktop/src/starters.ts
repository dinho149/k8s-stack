export const starters = [
  {
    id: 'react-ts',
    language: 'TypeScript',
    framework: 'React',
    description: 'React with Vite, unit tests, typechecking, and browser tests.',
    requires: 'Node.js 22.13–25 and npm',
  },
  {
    id: 'react-js',
    language: 'JavaScript',
    framework: 'React',
    description: 'React with Vite, unit tests, and browser tests.',
    requires: 'Node.js 22.13–25 and npm',
  },
  {
    id: 'vanilla-ts',
    language: 'TypeScript',
    framework: 'Plain web',
    description:
      'HTML, CSS, and TypeScript with Vite, unit tests, typechecking, and browser tests.',
    requires: 'Node.js 22.13–25 and npm',
  },
  {
    id: 'vanilla-js',
    language: 'JavaScript',
    framework: 'Plain web',
    description: 'HTML, CSS, and JavaScript with Vite, unit tests, and browser tests.',
    requires: 'Node.js 22.13–25 and npm',
  },
  {
    id: 'fastapi-python',
    language: 'Python',
    framework: 'FastAPI',
    description: 'A FastAPI HTTP service with a JSON greeting and pytest API tests.',
    requires: 'Python 3.10+ with pip and venv',
  },
  {
    id: 'http-go',
    language: 'Go',
    framework: 'Standard library HTTP',
    description: 'A Go HTTP service with a JSON greeting, handler tests, and build checks.',
    requires: 'Go 1.25+',
  },
] as const;

export type StarterId = (typeof starters)[number]['id'];
export const defaultStarterId: StarterId = 'react-ts';
export function getStarter(id: unknown = defaultStarterId) {
  const starter = starters.find((entry) => entry.id === id);
  if (!starter) throw new Error('Choose a supported project starter.');
  return starter;
}
