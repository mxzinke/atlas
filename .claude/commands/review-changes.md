---
allowed-tools: Bash(git diff:*),Bash(git status:*),Bash(git log:*)
description: Review the current changes (staged or on the branch)
argument-hint: [branch or staged]
---

## Review Process

Perform a comprehensive code review using subagents for key areas:

- architecture-reviewer
- code-quality-reviewer
- performance-reviewer
- documentation-reviewer
- security-code-reviewer

Instruct each to only provide noteworthy feedback. Take cross-impacted code into consideration. Once they finish, review the feedback and create a feedback summary for the most noteworthy feedback. Do reference files clearly.

```feedback-format
# [Short feedback title]

[Short summary with most noteworthy feedback]

## Direct Issues

[The following is listing each issue which are directly related to the changes. In case no issue found just say "Approval, no issue found."]

### 1. [Short title explaining the type of issue]

[Short but detailed description of the effects on the misbehaving / wrong / impacted code with clear reference what files are impacted. No need to tell about prioities or difficulity of the issue. Creator should be able to easily understand the issue.]

### 2. [Next issue ...]

[...]

## Cross Impact Issues

[A list or summary of issues caused by the changes in other parts of the code base. Ignore this section when non-found.]

### [Optional Section:] General Observations

[Additional general observations, not tied to a specific line of code. May include architectural concerns, unclear requirements that need discussion]

### [Optional Section:] Missing Details Issues

[List of files missed on related changes (e.g. missing documentation) or missing test caseses]

## References

[List to important file references, web research references or references to prepared AI prompts for agents.]
```

In case there is any existing issues/violations, please create a comprehensive temporary markdown document in `./tmp` folder (within project). The document should contain a prompt for AI agents, to easily fix these issues. If multiple big issues existing, may split it into multiple files.

Please use the following format for the AI prompt preparations:

```ai-prompt-format-example
Check if this issue is valid — if so, understand the root cause and fix it.

At repo/path/to/file.ts there is an issue ...

[Note: May multiple files can be referenced at once, to give full details. Goal is that AI can fully understand the issue and help fix it. Its formated as text, so copy-paste can be done easily.]

<file name="repo/path/to/file.ts">

<violation number="1" location="repo/path/to/file.ts:86">
[Here comes a more close explaination what violation/issue actually exist. It can exist more then one violation related to the issue. May reference code shortly and explain what cross impact it can have.]
</violation>

<violation number="2" location="repo/path/to/file.ts:210">
[Other violations in the same file, if applicable.]
</violation>

</file>
```

Keep feedback very concise and precision crafted for the actual issues. Stick to the formats above.

---

Git Status:

!`git status`

Please clearly focus on the changes in $ARGUMENTS
