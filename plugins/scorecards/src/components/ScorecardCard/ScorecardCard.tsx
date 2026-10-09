import { Progress, ResponseErrorPanel } from '@backstage/core-components';
import { fetchApiRef, useApi } from '@backstage/frontend-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { scorecardChecks } from '@internal/backstage-plugin-scorecards-common';
import { Badge, Card, CardBody, CardHeader, Flex, Text } from '@backstage/ui';
import CheckIcon from '@material-ui/icons/CheckCircleOutline';
import CrossIcon from '@material-ui/icons/HighlightOff';
import useAsync from 'react-use/esm/useAsync';
import { getScorecard } from '../../api';

export const ScorecardCard = () => {
  const { entity } = useEntity();
  const fetchApi = useApi(fetchApiRef);
  const { value, loading, error } = useAsync(
    () =>
      getScorecard(fetchApi, {
        kind: entity.kind,
        namespace: entity.metadata.namespace ?? 'default',
        name: entity.metadata.name,
      }),
    [fetchApi, entity],
  );

  return (
    <Card>
      <CardHeader>
        <Flex justify="between" align="center">
          <Text as="h3" variant="title-x-small" weight="bold">
            Scorecard
          </Text>
          {value && <Badge>{`${value.score}%`}</Badge>}
        </Flex>
      </CardHeader>
      <CardBody>
        {loading && <Progress />}
        {error && <ResponseErrorPanel error={error} />}
        {value && (
          <Flex direction="column" gap="2">
            {/* Shared definitions decide what is shown; the backend decides
                what passes */}
            {scorecardChecks.map(check => (
              <Flex key={check.id} align="center" gap="2">
                {value.checks.find(c => c.id === check.id)?.passed ? (
                  <CheckIcon fontSize="small" style={{ color: 'green' }} />
                ) : (
                  <CrossIcon fontSize="small" color="error" />
                )}
                <Text>{check.title}</Text>
                <Text variant="body-small" color="secondary">
                  {check.description}
                </Text>
              </Flex>
            ))}
          </Flex>
        )}
      </CardBody>
    </Card>
  );
};
