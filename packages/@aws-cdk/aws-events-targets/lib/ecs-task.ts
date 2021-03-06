import * as ec2 from '@aws-cdk/aws-ec2';
import * as ecs from '@aws-cdk/aws-ecs';
import * as events from '@aws-cdk/aws-events';
import * as iam from '@aws-cdk/aws-iam';
import { ContainerOverride } from './ecs-task-properties';
import { singletonEventRole } from './util';

/**
 * Properties to define an ECS Event Task
 */
export interface EcsTaskProps {
  /**
   * Cluster where service will be deployed
   */
  readonly cluster: ecs.ICluster;

  /**
   * Task Definition of the task that should be started
   */
  readonly taskDefinition: ecs.TaskDefinition;

  /**
   * How many tasks should be started when this event is triggered
   *
   * @default 1
   */
  readonly taskCount?: number;

  /**
   * Container setting overrides
   *
   * Key is the name of the container to override, value is the
   * values you want to override.
   */
  readonly containerOverrides?: ContainerOverride[];

  /**
   * In what subnets to place the task's ENIs
   *
   * (Only applicable in case the TaskDefinition is configured for AwsVpc networking)
   *
   * @default Private subnets
   */
  readonly subnetSelection?: ec2.SubnetSelection;

  /**
   * Existing security group to use for the task's ENIs
   *
   * (Only applicable in case the TaskDefinition is configured for AwsVpc networking)
   *
   * @default A new security group is created
   * @deprecated use securityGroups instead
   */
  readonly securityGroup?: ec2.ISecurityGroup;

  /**
   * Existing security groups to use for the task's ENIs
   *
   * (Only applicable in case the TaskDefinition is configured for AwsVpc networking)
   *
   * @default A new security group is created
   */
  readonly securityGroups?: ec2.ISecurityGroup[];
}

/**
 * Start a task on an ECS cluster
 */
export class EcsTask implements events.IRuleTarget {
  // Security group fields are public because we can generate a new security group if none is provided.

  /**
   * The security group associated with the task. Only applicable with awsvpc network mode.
   *
   * @default - A new security group is created.
   * @deprecated use securityGroups instead.
   */
  public readonly securityGroup?: ec2.ISecurityGroup;

  /**
   * The security groups associated with the task. Only applicable with awsvpc network mode.
   *
   * @default - A new security group is created.
   */
  public readonly securityGroups?: ec2.ISecurityGroup[];
  private readonly cluster: ecs.ICluster;
  private readonly taskDefinition: ecs.TaskDefinition;
  private readonly taskCount: number;

  constructor(private readonly props: EcsTaskProps) {
    if (props.securityGroup !== undefined && props.securityGroups !== undefined) {
      throw new Error('Only one of SecurityGroup or SecurityGroups can be populated.');
    }

    this.cluster = props.cluster;
    this.taskDefinition = props.taskDefinition;
    this.taskCount = props.taskCount !== undefined ? props.taskCount : 1;

    // Security groups are only configurable with the "awsvpc" network mode.
    if (this.taskDefinition.networkMode !== ecs.NetworkMode.AWS_VPC) {
      if (props.securityGroup !== undefined || props.securityGroups !== undefined) {
        this.taskDefinition.node.addWarning('security groups are ignored when network mode is not awsvpc');
      }
      return;
    }
    if (props.securityGroups) {
      this.securityGroups = props.securityGroups;
      return;
    }
    let securityGroup = props.securityGroup || this.taskDefinition.node.tryFindChild('SecurityGroup') as ec2.ISecurityGroup;
    securityGroup = securityGroup || new ec2.SecurityGroup(this.taskDefinition, 'SecurityGroup', { vpc: this.props.cluster.vpc });
    this.securityGroup = securityGroup; // Maintain backwards-compatibility for customers that read the generated security group.
    this.securityGroups = [securityGroup];
  }

  /**
   * Allows using tasks as target of CloudWatch events
   */
  public bind(_rule: events.IRule, _id?: string): events.RuleTargetConfig {
    const policyStatements = [new iam.PolicyStatement({
      actions: ['ecs:RunTask'],
      resources: [this.taskDefinition.taskDefinitionArn],
      conditions: {
        ArnEquals: { 'ecs:cluster': this.cluster.clusterArn },
      },
    })];

    // If it so happens that a Task Execution Role was created for the TaskDefinition,
    // then the CloudWatch Events Role must have permissions to pass it (otherwise it doesn't).
    if (this.taskDefinition.executionRole !== undefined) {
      policyStatements.push(new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [this.taskDefinition.executionRole.roleArn],
      }));
    }

    // For Fargate task we need permission to pass the task role.
    if (this.taskDefinition.isFargateCompatible) {
      policyStatements.push(new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [this.taskDefinition.taskRole.roleArn],
      }));
    }

    const arn = this.cluster.clusterArn;
    const role = singletonEventRole(this.taskDefinition, policyStatements);
    const containerOverrides = this.props.containerOverrides && this.props.containerOverrides
      .map(({ containerName, ...overrides }) => ({ name: containerName, ...overrides }));
    const input = { containerOverrides };
    const taskCount = this.taskCount;
    const taskDefinitionArn = this.taskDefinition.taskDefinitionArn;

    const subnetSelection = this.props.subnetSelection || { subnetType: ec2.SubnetType.PRIVATE };
    const assignPublicIp = subnetSelection.subnetType === ec2.SubnetType.PUBLIC ? 'ENABLED' : 'DISABLED';

    const baseEcsParameters = { taskCount, taskDefinitionArn };

    const ecsParameters: events.CfnRule.EcsParametersProperty = this.taskDefinition.networkMode === ecs.NetworkMode.AWS_VPC
      ? {
        ...baseEcsParameters,
        launchType: this.taskDefinition.isEc2Compatible ? 'EC2' : 'FARGATE',
        networkConfiguration: {
          awsVpcConfiguration: {
            subnets: this.props.cluster.vpc.selectSubnets(subnetSelection).subnetIds,
            assignPublicIp,
            securityGroups: this.securityGroups && this.securityGroups.map(sg => sg.securityGroupId),
          },
        },
      }
      : baseEcsParameters;

    return {
      id: '',
      arn,
      role,
      ecsParameters,
      input: events.RuleTargetInput.fromObject(input),
      targetResource: this.taskDefinition,
    };
  }
}
