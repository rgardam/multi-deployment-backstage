import { useState } from 'react';
import { Progress, ResponseErrorPanel } from '@backstage/core-components';
import { fetchApiRef, useApi } from '@backstage/frontend-plugin-api';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  Container,
  Flex,
  Header,
  Text,
  TextAreaField,
  TextField,
} from '@backstage/ui';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import { listNotices, postNotice } from '../../api';
import { NoticeList } from '../NoticeList';

export const NoticeboardPage = () => {
  const fetchApi = useApi(fetchApiRef);
  const notices = useAsyncRetry(() => listNotices(fetchApi), [fetchApi]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string>();

  const post = async () => {
    setPosting(true);
    setPostError(undefined);
    try {
      await postNotice(fetchApi, { title, body });
      setTitle('');
      setBody('');
      notices.retry();
    } catch (error) {
      setPostError(String(error));
    } finally {
      setPosting(false);
    }
  };

  return (
    <>
      <Header
        title="Noticeboard"
        description="Served by a local plugin running inside backend-core"
      />
      <Container>
        <Flex direction="column" gap="4">
          <Card>
            <CardHeader>
              <Text as="h2" variant="title-small">
                Post a notice
              </Text>
            </CardHeader>
            <CardBody>
              <Flex direction="column" gap="3">
                <TextField label="Title" value={title} onChange={setTitle} />
                <TextAreaField
                  label="Notice"
                  value={body}
                  onChange={setBody}
                  rows={3}
                />
                {postError && <Alert status="danger" title={postError} />}
                <Flex justify="end">
                  <Button
                    onPress={post}
                    isDisabled={!title.trim() || !body.trim()}
                    loading={posting}
                  >
                    Post
                  </Button>
                </Flex>
              </Flex>
            </CardBody>
          </Card>
          {notices.loading && <Progress />}
          {notices.error && <ResponseErrorPanel error={notices.error} />}
          {notices.value && <NoticeList notices={notices.value} />}
        </Flex>
      </Container>
    </>
  );
};
