export interface GraveStory {
  name: string
  inscription: string
  story: string
  cause: string
}

/** Fictional epitaphs for illustrative cemetery props; these are not repository diagnoses. */
export const graveStories: GraveStory[] = [
  { name: 'THE UNFINISHED PROJECT', inscription: 'Started with ambition. Never reached completion.', story: 'The developer began something ambitious, but left before its central features were finished. The final commit became its last sign of life.', cause: 'INCOMPLETE DEVELOPMENT' },
  { name: 'THE DEPENDENCY DISASTER', inscription: 'One update changed everything.', story: 'A dependency moved to an incompatible release. The application stopped building, and nobody traced the failure to its source.', cause: 'BREAKING DEPENDENCY UPDATE' },
  { name: 'THE FORGOTTEN HACKATHON', inscription: 'Built in 48 hours. Forgotten forever.', story: 'It was born during a hackathon. When the event ended, nobody returned to maintain the code or repair the issues that followed.', cause: 'ABANDONED AFTER HACKATHON' },
  { name: 'THE VERSION VICTIM', inscription: 'Worked yesterday. Failed today.', story: 'A runtime or package version changed, leaving yesterday’s working code incompatible with its new environment.', cause: 'VERSION INCOMPATIBILITY' },
  { name: 'THE SILENT REPOSITORY', inscription: 'No commits. No fixes. No second chances.', story: 'Updates stopped arriving. Dependencies grew old, documentation lost its meaning, and the repository slowly disappeared from memory.', cause: 'LACK OF MAINTENANCE' },
  { name: 'THE BROKEN BUILD', inscription: 'One error was enough.', story: 'A build configuration or compilation error kept the project from running. The issue remained unresolved until development ceased.', cause: 'BUILD FAILURE' },
]
