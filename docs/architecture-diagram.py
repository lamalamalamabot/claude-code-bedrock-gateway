"""
Claude Code Bedrock Gateway - Architecture Diagram
Clean top-down layout with clear subnet placement and numbered flows.
"""

from diagrams import Cluster, Diagram, Edge
from diagrams.aws.compute import ECS, Lambda
from diagrams.aws.database import Aurora, Dynamodb
from diagrams.aws.general import Users
from diagrams.aws.management import Cloudwatch
from diagrams.aws.ml import Bedrock
from diagrams.aws.network import ALB, NATGateway, Endpoint, APIGateway
from diagrams.aws.integration import SNS
from diagrams.aws.security import IAMRole, SecretsManager, SingleSignOn


graph_attr = {
    "fontsize": "20",
    "bgcolor": "white",
    "pad": "1.5",
    "nodesep": "0.8",
    "ranksep": "1.2",
    "dpi": "150",
}

with Diagram(
    "Claude Code Bedrock Gateway - Architecture",
    filename="/home/ec2-user/claude-code-bedrock-gateway/docs/architecture",
    show=False,
    direction="TB",
    graph_attr=graph_attr,
    outformat="png",
):

    # Top: Users
    devs = Users("Developers\n(4,000 SSO Users)")

    # Payer Account
    with Cluster("Payer Account (Organization Mgmt)"):
        idc = SingleSignOn("IAM Identity Center\n(Users & Groups)")
        idc_role = IAMRole("IdentityStoreReadRole")

    # Member Account
    with Cluster("Member Account (ap-northeast-2)"):

        # API Gateway outside VPC
        apigw = APIGateway("API Gateway\n/auth/token\n(IAM Auth)")

        # Managed services
        secrets = SecretsManager("Secrets Manager")
        config_ddb = Dynamodb("Config Table\n(Virtual Key Cache)")
        audit_ddb = Dynamodb("Audit Table\n(Usage Logs)")

        # VPC
        with Cluster("VPC (10.0.0.0/16, 2 AZ)"):

            with Cluster("Public Subnet (AZ-a, AZ-c)"):
                alb = ALB("ALB (Internet-facing)\nSG: Specific IP\nPort 443")
                nat = NATGateway("NAT Gateway")

            with Cluster("Private Subnet - NAT Egress (AZ-a, AZ-c)"):
                ecs = ECS("ECS Fargate Service\nLiteLLM Proxy\n2 vCPU / 4 GB\nAuto Scale: 1-10\nSG: ALB→4000")
                lmb = Lambda("Token Service Lambda\nPython 3.12\nSG: Outbound only")
                vpce = Endpoint("VPC Endpoint\nBedrock Runtime\nSG: ECS→443")

            with Cluster("Isolated Subnet (AZ-a, AZ-c)"):
                aurora = Aurora("Aurora Serverless v2\nPostgreSQL 15.15\n0.5-4 ACU\nSG: ECS/Lambda→5432")

        # Monitoring
        cw = Cloudwatch("CloudWatch\nDashboard & Alarms")
        sns_topic = SNS("SNS Alerts")

    # Bedrock
    bedrock = Bedrock("Amazon Bedrock\nglobal.anthropic.claude-*\n(Cross-Region Inference)")

    # ===== Auth Flow =====
    devs >> Edge(label="① SSO Login", color="royalblue") >> idc
    devs >> Edge(label="② POST /auth/token\n(SigV4)", color="royalblue", style="bold") >> apigw
    apigw >> Edge(label="③ Invoke", color="royalblue") >> lmb

    # Lambda actions
    lmb >> Edge(label="④ STS AssumeRole\n→ Group Lookup", color="darkorange", style="dashed") >> idc_role
    lmb >> Edge(label="⑤ Get Master Key", color="slategray") >> secrets
    lmb >> Edge(label="⑥ Get/Put Item", color="seagreen") >> config_ddb
    lmb >> Edge(label="⑦ /key/generate\n(NAT → ALB → ECS)", color="crimson") >> ecs

    # ===== Data Flow =====
    devs >> Edge(label="⑧ Claude API Call\n(Virtual Key)", color="darkgreen", style="bold") >> alb
    alb >> Edge(label="→ Port 4000", color="darkgreen") >> ecs

    # ECS actions
    ecs >> Edge(label="⑨ InvokeModel\n(PrivateLink)", color="darkviolet", style="bold") >> vpce
    vpce >> Edge(color="darkviolet") >> bedrock
    ecs >> Edge(label="⑩ Query/Write", color="saddlebrown") >> aurora
    ecs >> Edge(label="⑪ PutItem (Audit)", color="slategray") >> audit_ddb
    ecs >> Edge(label="GHCR Pull", color="gray", style="dotted") >> nat

    # Monitoring
    cw >> Edge(style="dotted", color="gray") >> sns_topic
