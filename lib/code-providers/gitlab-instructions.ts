/** Shared by the session guide and the explicit Create PR attachment. */
export const GITLAB_MERGE_REQUEST_INSTRUCTIONS = `This repository is hosted on GitLab.com. Open a GitLab merge request for it.
Use the GitLab REST API at https://gitlab.com/api/v4/projects/<URL-encoded group/project>/merge_requests.
Read the namespace from the origin remote, including every subgroup. Obtain its token through git credential fill for that HTTPS remote, capturing the output in memory; never print it or place it in command arguments or a file.
Use the returned password as the PRIVATE-TOKEN request header. POST source_branch, target_branch, title and description as JSON to create the merge request; first list merge requests for source_branch to avoid duplicates, and PUT /merge_requests/<iid> to update an existing one.
Apply the review, evidence, commit attribution and description rules below to the merge request. References to PRs mean merge requests here; replace gh commands with these GitLab API operations.`;

export const REPOSITORY_HOST_INSTRUCTIONS = `Before opening or updating a pull request, inspect git remote get-url origin. If its host is gitlab.com, follow these provider instructions:

${GITLAB_MERGE_REQUEST_INSTRUCTIONS}`;
