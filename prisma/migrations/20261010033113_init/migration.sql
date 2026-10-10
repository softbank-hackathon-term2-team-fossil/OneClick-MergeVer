-- CreateEnum
CREATE TYPE "ServerAuthType" AS ENUM ('PASSWORD', 'PRIVATE_KEY');

-- CreateEnum
CREATE TYPE "DeployTarget" AS ENUM ('ONPREM', 'AWS', 'AZURE');

-- CreateEnum
CREATE TYPE "DeployTrigger" AS ENUM ('MANUAL', 'ROLLBACK');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "repository" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Server" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "sshPort" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL,
    "hostPort" INTEGER NOT NULL,
    "containerPort" INTEGER NOT NULL,
    "authType" "ServerAuthType" NOT NULL,
    "encryptedCredential" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Server_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "target" "DeployTarget" NOT NULL,
    "trigger" "DeployTrigger" NOT NULL DEFAULT 'MANUAL',
    "sourceDeploymentId" TEXT,
    "imageTag" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "destination" TEXT,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'RUNNING',
    "failureReason" TEXT,
    "url" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_installationId_repository_key" ON "Project"("installationId", "repository");

-- CreateIndex
CREATE UNIQUE INDEX "Server_projectId_key" ON "Server"("projectId");

-- CreateIndex
CREATE INDEX "Deployment_projectId_target_startedAt_idx" ON "Deployment"("projectId", "target", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_projectId_number_key" ON "Deployment"("projectId", "number");

-- AddForeignKey
ALTER TABLE "Server" ADD CONSTRAINT "Server_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
