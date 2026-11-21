/** Shared session operations dispatch by the repository's canonical reference.
 * Provider-specific listing and app installation APIs remain separate. */
import { isGitLabRef } from "@/lib/code-providers/repository";
import * as github from "@/lib/github/client";
import { getGitLabRepository } from "@/lib/gitlab/client";
import { branchKnownOnGitLab, branchOnGitLab, findMergeRequest, listGitLabBranches, mergeMergeRequest, mergeRequestStatus } from "@/lib/gitlab/merge-requests";

export async function getRepository(token: string, ref: string) {
  return isGitLabRef(ref) ? getGitLabRepository(token, ref) : github.getGitHubRepository(token, ref);
}

export function branchKnown(input: Parameters<typeof github.branchKnownOnGitHub>[0]) {
  return isGitLabRef(input.repoFullName) ? branchKnownOnGitLab(input) : github.branchKnownOnGitHub(input);
}

export function branchExists(input: Parameters<typeof github.branchOnGitHub>[0]) {
  return isGitLabRef(input.repoFullName) ? branchOnGitLab(input) : github.branchOnGitHub(input);
}

export function listBranches(input: Parameters<typeof github.listGitHubBranches>[0]) {
  return isGitLabRef(input.repoFullName) ? listGitLabBranches(input) : github.listGitHubBranches(input);
}

export function findPullRequest(input: Parameters<typeof github.findPullRequest>[0]) {
  return isGitLabRef(input.repoFullName) ? findMergeRequest(input) : github.findPullRequest(input);
}

export async function getPullRequestStatus(input: Parameters<typeof github.getPullRequestStatus>[0]) {
  return isGitLabRef(input.repoFullName) ? (await mergeRequestStatus(input)).status : github.getPullRequestStatus(input);
}

export function getPullRequestStatusWithDetails(input: Parameters<typeof github.getPullRequestStatusWithDetails>[0]) {
  return isGitLabRef(input.repoFullName) ? mergeRequestStatus(input) : github.getPullRequestStatusWithDetails(input);
}

export function mergePullRequest(input: Parameters<typeof github.mergePullRequest>[0]) {
  return isGitLabRef(input.repoFullName) ? mergeMergeRequest(input) : github.mergePullRequest(input);
}
