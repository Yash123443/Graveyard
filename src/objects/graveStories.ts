export interface GraveStory {
  name: string
  inscription: string
  story: string
  cause: string
}

/** Fictional epitaphs for illustrative cemetery props; these are not repository diagnoses. */
export const graveStories: GraveStory[] = [
  { name: 'THE UNFINISHED PROJECT', inscription: 'Started with ambition. Never reached completion.', story: 'A project started with big ambitions but was abandoned before its main features were completed.', cause: 'INCOMPLETE DEVELOPMENT' },
  { name: 'THE DEPENDENCY DISASTER', inscription: 'One update changed everything.', story: 'A dependency update introduced an incompatible version. The project stopped building, and nobody investigated the breaking release.', cause: 'BREAKING DEPENDENCY UPDATE' },
  { name: 'THE FORGOTTEN HACKATHON', inscription: 'Built in 48 hours. Forgotten forever.', story: 'A promising hackathon project was abandoned after the event and never maintained.', cause: 'ABANDONMENT' },
  { name: 'THE VERSION VICTIM', inscription: 'Worked yesterday. Failed today.', story: 'A runtime or package version changed and made previously working code incompatible.', cause: 'VERSION INCOMPATIBILITY' },
  { name: 'THE SILENT REPOSITORY', inscription: 'No commits. No fixes. No second chances.', story: 'The repository gradually stopped receiving updates. Dependencies became outdated and the project was forgotten.', cause: 'LACK OF MAINTENANCE' },
  { name: 'THE BROKEN BUILD', inscription: 'One error was enough.', story: 'A build configuration or compilation error prevented the project from running again.', cause: 'BUILD FAILURE' },
]
